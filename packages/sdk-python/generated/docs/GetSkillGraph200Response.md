# GetSkillGraph200Response


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**edges** | [**List[GetSkillGraph200ResponseEdgesInner]**](GetSkillGraph200ResponseEdgesInner.md) |  |
**metadata** | [**GetSkillGraph200ResponseMetadata**](GetSkillGraph200ResponseMetadata.md) |  |
**mode** | **str** |  | [optional]
**nodes** | [**List[GetSkillGraph200ResponseNodesInner]**](GetSkillGraph200ResponseNodesInner.md) |  |
**root** | [**GetSkillGraph200ResponseRoot**](GetSkillGraph200ResponseRoot.md) |  | [optional]

## Example

```python
from openapi_client.models.get_skill_graph200_response import GetSkillGraph200Response

# TODO update the JSON string below
json = "{}"
# create an instance of GetSkillGraph200Response from a JSON string
get_skill_graph200_response_instance = GetSkillGraph200Response.from_json(json)
# print the JSON string representation of the object
print(GetSkillGraph200Response.to_json())

# convert the object into a dict
get_skill_graph200_response_dict = get_skill_graph200_response_instance.to_dict()
# create an instance of GetSkillGraph200Response from a dict
get_skill_graph200_response_from_dict = GetSkillGraph200Response.from_dict(get_skill_graph200_response_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
