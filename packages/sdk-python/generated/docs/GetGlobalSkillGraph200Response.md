# GetGlobalSkillGraph200Response


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**edges** | [**List[GetGlobalSkillGraph200ResponseEdgesInner]**](GetGlobalSkillGraph200ResponseEdgesInner.md) |  |
**metadata** | [**GetGlobalSkillGraph200ResponseMetadata**](GetGlobalSkillGraph200ResponseMetadata.md) |  |
**mode** | **str** |  | [optional]
**nodes** | [**List[GetGlobalSkillGraph200ResponseNodesInner]**](GetGlobalSkillGraph200ResponseNodesInner.md) |  |
**root** | [**GetGlobalSkillGraph200ResponseRoot**](GetGlobalSkillGraph200ResponseRoot.md) |  | [optional]

## Example

```python
from openapi_client.models.get_global_skill_graph200_response import GetGlobalSkillGraph200Response

# TODO update the JSON string below
json = "{}"
# create an instance of GetGlobalSkillGraph200Response from a JSON string
get_global_skill_graph200_response_instance = GetGlobalSkillGraph200Response.from_json(json)
# print the JSON string representation of the object
print(GetGlobalSkillGraph200Response.to_json())

# convert the object into a dict
get_global_skill_graph200_response_dict = get_global_skill_graph200_response_instance.to_dict()
# create an instance of GetGlobalSkillGraph200Response from a dict
get_global_skill_graph200_response_from_dict = GetGlobalSkillGraph200Response.from_dict(get_global_skill_graph200_response_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
