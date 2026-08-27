# GetGlobalSkillGraph200ResponseNodesInner


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**body_sha256** | **str** |  |
**created_at** | **str** |  | [optional]
**history** | **List[int]** |  | [optional]
**id** | **str** |  |
**kind** | **str** |  |
**lifecycle** | **str** |  |
**logical_key** | **str** |  |
**metadata** | **object** |  | [optional]
**name** | **str** |  |
**owner** | **str** |  | [optional]
**resources** | [**List[SearchSkills200ResponseItemsInnerResourcesInner]**](SearchSkills200ResponseItemsInnerResourcesInner.md) |  |
**scope** | [**GetGlobalSkillGraph200ResponseNodesInnerScope**](GetGlobalSkillGraph200ResponseNodesInnerScope.md) |  | [optional]
**selection** | **object** |  | [optional]
**total_size** | **int** |  |
**updated_at** | **str** |  | [optional]
**version** | **int** |  |
**skill_id** | **str** |  |

## Example

```python
from openapi_client.models.get_global_skill_graph200_response_nodes_inner import GetGlobalSkillGraph200ResponseNodesInner

# TODO update the JSON string below
json = "{}"
# create an instance of GetGlobalSkillGraph200ResponseNodesInner from a JSON string
get_global_skill_graph200_response_nodes_inner_instance = GetGlobalSkillGraph200ResponseNodesInner.from_json(json)
# print the JSON string representation of the object
print(GetGlobalSkillGraph200ResponseNodesInner.to_json())

# convert the object into a dict
get_global_skill_graph200_response_nodes_inner_dict = get_global_skill_graph200_response_nodes_inner_instance.to_dict()
# create an instance of GetGlobalSkillGraph200ResponseNodesInner from a dict
get_global_skill_graph200_response_nodes_inner_from_dict = GetGlobalSkillGraph200ResponseNodesInner.from_dict(get_global_skill_graph200_response_nodes_inner_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
