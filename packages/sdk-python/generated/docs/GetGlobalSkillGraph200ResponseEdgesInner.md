# GetGlobalSkillGraph200ResponseEdgesInner


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**constraint** | **str** |  |
**direction** | **str** |  |
**reason** | **str** |  | [optional]
**source** | **str** |  |
**source_version** | **int** |  |
**target** | **str** |  |
**target_version** | **int** |  |
**type** | **str** |  |

## Example

```python
from openapi_client.models.get_global_skill_graph200_response_edges_inner import GetGlobalSkillGraph200ResponseEdgesInner

# TODO update the JSON string below
json = "{}"
# create an instance of GetGlobalSkillGraph200ResponseEdgesInner from a JSON string
get_global_skill_graph200_response_edges_inner_instance = GetGlobalSkillGraph200ResponseEdgesInner.from_json(json)
# print the JSON string representation of the object
print(GetGlobalSkillGraph200ResponseEdgesInner.to_json())

# convert the object into a dict
get_global_skill_graph200_response_edges_inner_dict = get_global_skill_graph200_response_edges_inner_instance.to_dict()
# create an instance of GetGlobalSkillGraph200ResponseEdgesInner from a dict
get_global_skill_graph200_response_edges_inner_from_dict = GetGlobalSkillGraph200ResponseEdgesInner.from_dict(get_global_skill_graph200_response_edges_inner_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
